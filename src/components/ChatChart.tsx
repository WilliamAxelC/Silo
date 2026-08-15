import React from 'react';
import { View, Text, StyleSheet, Dimensions } from 'react-native';
import { BarChart, LineChart, PieChart } from 'react-native-gifted-charts';
import { useAppTheme } from '../theme/useAppTheme';

interface ChatChartProps {
  type: string;
  data: string;
}

const PALETTE = ['#0ea5e9', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];

export const ChatChart = React.memo(function ChatChart({ type, data }: ChatChartProps) {
  const theme = useAppTheme();
  const screenWidth = Dimensions.get('window').width;
  const maxChartWidth = Math.min(screenWidth - 60, 320);

  let parsedData: any[] = [];

  try {
    const rawData = JSON.parse(data.replace(/&quot;/g, '"'));
    if (Array.isArray(rawData)) {
      parsedData = rawData.map((item, index) => {
        if (typeof item === 'number') {
          return { value: item, label: `${index + 1}` };
        }
        return {
          ...item,
          value: typeof item.value === 'number' ? item.value : parseFloat(item.value) || 0,
        };
      });
    }
  } catch {
    return (
      <View style={[styles.errorContainer, { backgroundColor: theme.surface, borderColor: theme.border }]}>
        <Text style={{ color: theme.expense, fontSize: 12 }}>Unable to display chart preview.</Text>
      </View>
    );
  }

  if (parsedData.length === 0) {
    return null;
  }

  const commonProps = {
    textColor: theme.text,
    axesColor: theme.border,
    xAxisColor: theme.border,
    yAxisColor: theme.border,
    rulesColor: theme.border,
    xAxisLabelTextStyle: { color: theme.textMuted, fontSize: 11 },
    yAxisTextStyle: { color: theme.textMuted, fontSize: 11 },
    frontColor: theme.primary,
  };

  const pieData = parsedData.map((d, i) => ({
    ...d,
    color: d.color || PALETTE[i % PALETTE.length],
    text: d.label ? `${d.label}` : `${d.value}`,
  }));

  return (
    <View style={[styles.chartContainer, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      <View style={styles.chartHeader}>
        <Text style={[styles.chartTitle, { color: theme.text }]}>
          {type.toUpperCase()} ANALYSIS
        </Text>
      </View>

      {type === 'line' ? (
        <View style={styles.chartWrapper}>
          <LineChart
            data={parsedData}
            color={theme.primary}
            dataPointsColor={theme.primary}
            thickness={2.5}
            width={maxChartWidth - 40}
            height={160}
            curved
            isAnimated
            animationDuration={600}
            {...commonProps}
          />
        </View>
      ) : type === 'pie' ? (
        <View style={styles.pieContainer}>
          <PieChart
            data={pieData}
            radius={75}
            innerRadius={45}
            textColor="#fff"
            textSize={11}
            isAnimated
            animationDuration={600}
          />
          {/* Legend */}
          <View style={styles.legendWrap}>
            {pieData.map((item, idx) => (
              <View key={idx} style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: item.color }]} />
                <Text style={[styles.legendLabel, { color: theme.text }]} numberOfLines={1}>
                  {item.label || `Item ${idx + 1}`}: <Text style={{ fontWeight: '700' }}>{item.value}</Text>
                </Text>
              </View>
            ))}
          </View>
        </View>
      ) : (
        <View style={styles.chartWrapper}>
          <BarChart
            data={parsedData}
            barWidth={20}
            spacing={14}
            noOfSections={4}
            barBorderRadius={6}
            width={maxChartWidth - 40}
            height={160}
            isAnimated
            animationDuration={600}
            {...commonProps}
          />
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  errorContainer: {
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    marginVertical: 6,
  },
  chartContainer: {
    marginVertical: 10,
    padding: 12,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    width: '100%',
  },
  chartHeader: {
    alignSelf: 'flex-start',
    marginBottom: 8,
  },
  chartTitle: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  chartWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
  },
  pieContainer: {
    alignItems: 'center',
    paddingVertical: 8,
    width: '100%',
  },
  legendWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 8,
    marginTop: 12,
    paddingHorizontal: 8,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 8,
    marginBottom: 4,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  legendLabel: {
    fontSize: 11,
  },
});
